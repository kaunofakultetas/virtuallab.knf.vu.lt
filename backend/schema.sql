DO $$
BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'student');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE template_type AS ENUM ('student_vm', 'lab_vm');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE proxmox_status AS ENUM ('running', 'stopped', 'suspended');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE connection_type AS ENUM ('guacamole', 'ssh', 'web');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Add 'web' connection type for existing deployments (idempotent)
ALTER TYPE connection_type ADD VALUE IF NOT EXISTS 'web';

CREATE TABLE IF NOT EXISTS users (
    vu_id VARCHAR(255) PRIMARY KEY,
    password VARCHAR(255),
    role user_role NOT NULL DEFAULT 'student',
    last_login TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Allow NULL passwords for SSO-only users (idempotent)
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

-- The account's Guacamole password. Stored in the clear, unlike `password`
-- above, because the backend has to present it to Guacamole on the user's
-- behalf -- it authenticates this service to Guacamole, it is never something a
-- human types, and it is never returned by any API. It replaces the previous
-- scheme where the Guacamole password WAS the vu_id: a student number is
-- printed on ID cards, so anyone who could reach Guacamole could log in as
-- anyone. NULL means "not yet rotated"; the session route mints one on the next
-- connect and recreates the Guacamole account to match.
ALTER TABLE users ADD COLUMN IF NOT EXISTS guac_password VARCHAR(255);

-- The subject scheduled network reconciliation is recorded against.
-- `network_reconciliation_attempts.requested_by` is a foreign key to `users`, so
-- a background job needs a real row; attributing its changes to an arbitrary
-- admin would put a change nobody made under somebody's name. NULL password and
-- the `student` role mean it can never be used to log in or to authorise
-- anything -- it exists only so the audit trail can name a machine honestly.
INSERT INTO users (vu_id, password, role)
VALUES ('system-drift-reconciler', NULL, 'student')
ON CONFLICT (vu_id) DO NOTHING;

-- The subject a deleted account's audit rows are reattributed to.
-- `network_reconciliation_attempts.requested_by` is ON DELETE RESTRICT and those
-- rows are never deleted, so any user who ever provisioned an isolated VM could
-- not be removed -- and the deletion path destroyed their VMs BEFORE hitting
-- that constraint. Repointing to this tombstone keeps the audit trail (the
-- change still happened) without keeping the account. Same NULL password and
-- `student` role as above: it can never log in or authorise anything.
INSERT INTO users (vu_id, password, role)
VALUES ('deleted-user', NULL, 'student')
ON CONFLICT (vu_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS templates (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type template_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    proxmox_id VARCHAR(255) NOT NULL UNIQUE,
    visible_to_students BOOLEAN NOT NULL DEFAULT FALSE,
    connection_type connection_type NOT NULL DEFAULT 'guacamole',
    connection_config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent migrations for existing deployments
ALTER TABLE templates ADD COLUMN IF NOT EXISTS connection_type connection_type NOT NULL DEFAULT 'guacamole';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS connection_config JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS lab_profiles (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    allow_same_group BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS lab_profiles_single_default_idx
    ON lab_profiles (is_default)
    WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS lab_profile_templates (
    profile_id INT NOT NULL REFERENCES lab_profiles(id) ON DELETE CASCADE,
    template_id INT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    PRIMARY KEY (profile_id, template_id)
);

CREATE TABLE IF NOT EXISTS allowed_web_domains (
    profile_id INT NOT NULL REFERENCES lab_profiles(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    include_subdomains BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (profile_id, domain),
    CHECK (domain = lower(domain)),
    CHECK (domain !~ '[/:]'),
    CHECK (domain !~ '^\.' AND domain !~ '\.$')
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM lab_profiles WHERE is_default = TRUE) THEN
        UPDATE lab_profiles
        SET is_default = TRUE,
            updated_at = CURRENT_TIMESTAMP
        WHERE name = 'Default';

        IF NOT FOUND THEN
            INSERT INTO lab_profiles (name, description, allow_same_group, is_default)
            VALUES (
                'Default',
                'Default profile for templates created before lab profiles were introduced.',
                TRUE,
                TRUE
            );
        END IF;
    END IF;
END $$;

INSERT INTO lab_profile_templates (profile_id, template_id)
SELECT profile.id, template.id
FROM lab_profiles profile
CROSS JOIN templates template
WHERE profile.is_default = TRUE
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    CREATE TYPE network_group_state AS ENUM ('planned', 'creating', 'active', 'deleting', 'error');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE network_group_state ADD VALUE IF NOT EXISTS 'planned' BEFORE 'creating';

CREATE TABLE IF NOT EXISTS network_groups (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id VARCHAR(255) NOT NULL REFERENCES users(vu_id) ON DELETE RESTRICT,
    profile_id INT NOT NULL REFERENCES lab_profiles(id) ON DELETE RESTRICT,
    vlan_tag INT UNIQUE,
    vnet_name TEXT UNIQUE,
    subnet_cidr CIDR UNIQUE,
    state network_group_state NOT NULL DEFAULT 'planned',
    desired_revision TEXT,
    applied_revision TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, profile_id),
    CHECK (vlan_tag IS NULL OR vlan_tag BETWEEN 1 AND 4094)
);

ALTER TABLE network_groups ALTER COLUMN state SET DEFAULT 'planned';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM network_groups
        WHERE (vlan_tag IS NULL)::int
            + (vnet_name IS NULL)::int
            + (subnet_cidr IS NULL)::int NOT IN (0, 3)
           OR vlan_tag IS NOT NULL AND vlan_tag NOT BETWEEN 2000 AND 2255
           OR state = 'planned' AND vlan_tag IS NOT NULL
           OR state IN ('creating', 'active', 'deleting') AND vlan_tag IS NULL
    ) THEN
        RAISE EXCEPTION 'network_groups contains rows that violate allocation invariants';
    END IF;
END $$;

DO $$
BEGIN
    ALTER TABLE network_groups
        ADD CONSTRAINT network_groups_allocation_tuple_check
        CHECK (
            (vlan_tag IS NULL AND vnet_name IS NULL AND subnet_cidr IS NULL)
            OR
            (vlan_tag IS NOT NULL AND vnet_name IS NOT NULL AND subnet_cidr IS NOT NULL)
        );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE network_groups
        ADD CONSTRAINT network_groups_allocation_pool_check
        CHECK (vlan_tag IS NULL OR vlan_tag BETWEEN 2000 AND 2255);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE network_groups
        ADD CONSTRAINT network_groups_allocation_state_check
        CHECK (
            (state = 'planned' AND vlan_tag IS NULL)
            OR (state IN ('creating', 'active', 'deleting') AND vlan_tag IS NOT NULL)
            OR state = 'error'
        );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS network_reconciliation_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE,
    requested_by VARCHAR(255) NOT NULL REFERENCES users(vu_id) ON DELETE RESTRICT,
    idempotency_key TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
    desired_revision TEXT NOT NULL CHECK (desired_revision ~ '^[0-9a-f]{64}$'),
    applied_revision TEXT CHECK (applied_revision ~ '^[0-9a-f]{64}$'),
    phase TEXT NOT NULL DEFAULT 'initializing',
    checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_code TEXT,
    error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    CHECK (
        (status = 'running' AND finished_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'abandoned') AND finished_at IS NOT NULL)
    ),
    CHECK (
        mode <> 'apply'
        OR status <> 'succeeded'
        OR applied_revision = desired_revision
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS network_reconciliation_attempts_idempotency_idx
    ON network_reconciliation_attempts (requested_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_peerings (
    group_a_id INT NOT NULL REFERENCES network_groups(id) ON DELETE CASCADE,
    group_b_id INT NOT NULL REFERENCES network_groups(id) ON DELETE CASCADE,
    CHECK (group_a_id < group_b_id),
    PRIMARY KEY (group_a_id, group_b_id)
);

CREATE TABLE IF NOT EXISTS instances (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id VARCHAR(255),
    template_id INT,
    proxmox_id VARCHAR(255) NOT NULL,

    name VARCHAR(255) NOT NULL DEFAULT 'Unnamed VM',
    status proxmox_status NOT NULL DEFAULT 'stopped',
    data JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    run_until TIMESTAMPTZ,

    FOREIGN KEY (owner_id) REFERENCES users(vu_id) ON DELETE SET NULL,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE RESTRICT
);

-- template_id was ON DELETE SET NULL, which made deleting a template a silent
-- firewall change on every VM cloned from it: the reconciler read a NULL
-- connection type and (before the fallback was removed) rewrote the VM's one
-- ingress rule to RDP/3389. RESTRICT makes the deletion fail loudly instead, so
-- an admin is told which live instances still depend on the template.
-- DROP ... IF EXISTS then ADD, because the constraint already exists with the
-- old action and ADD alone would be a no-op guarded by duplicate_object.
DO $$
BEGIN
    ALTER TABLE instances DROP CONSTRAINT IF EXISTS instances_template_id_fkey;
    ALTER TABLE instances
        ADD CONSTRAINT instances_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE instances ADD COLUMN IF NOT EXISTS network_group_id INT;

-- Set while the VM is being cloned and started, NULL once the row describes a
-- real machine. The row is now written BEFORE the clone rather than after it,
-- because writing it after left a ~30-second window in which the per-student
-- quota counted a stale number and every `NOT EXISTS (SELECT 1 FROM instances
-- ...)` guard in the network state machine was blind to a VM that was already
-- being built. A crash mid-clone leaves this set, which is how the expiry
-- sweeper finds and reclaims an abandoned reservation.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ;

-- Set when a VM could not be given its firewall policy AND could not then be
-- destroyed -- i.e. it may be running unfiltered on a shared VLAN. Deliberately
-- a separate column rather than a `proxmox_status` value: the 15-second status
-- sync overwrites `status` for every VM it sees, so a status-based marker would
-- be erased on the next tick.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    ALTER TABLE instances
        ADD CONSTRAINT instances_network_group_id_fkey
        FOREIGN KEY (network_group_id) REFERENCES network_groups(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS metadata (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
