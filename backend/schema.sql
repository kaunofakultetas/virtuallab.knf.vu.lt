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

CREATE TABLE IF NOT EXISTS users (
    vu_id VARCHAR(255) PRIMARY KEY,
    role user_role NOT NULL DEFAULT 'student',
    last_login TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type template_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    proxmox_id VARCHAR(255) NOT NULL UNIQUE,
    visible_to_students BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vm_instances (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id VARCHAR(255),
    template_id INT,
    proxmox_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(vu_id) ON DELETE SET NULL,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);
