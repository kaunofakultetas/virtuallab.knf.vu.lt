import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router-dom";

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <Box sx={{ mb: 4 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }} gutterBottom>
                {title}
            </Typography>
            {children}
        </Box>
    );
}

function P({ children }: { children: React.ReactNode }) {
    return (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {children}
        </Typography>
    );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <Box sx={{ display: "flex", gap: 1, mb: 0.75 }}>
            <Typography
                variant="body2"
                color="text.secondary"
                sx={{ minWidth: 160, fontWeight: 600 }}
            >
                {label}
            </Typography>
            <Typography variant="body2" color="text.secondary">
                {value}
            </Typography>
        </Box>
    );
}

function BulletList({
    items,
}: {
    items: [string, string][];
}) {
    return (
        <Box component="ul" sx={{ pl: 2, mb: 2 }}>
            {items.map(([name, desc]) => (
                <Box component="li" key={name} sx={{ mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">
                        <strong>{name}</strong> — {desc}
                    </Typography>
                </Box>
            ))}
        </Box>
    );
}

export default function Privacy() {
    return (
        <Box sx={{ minHeight: "100vh", bgcolor: "background.default", py: 6 }}>
            <Container maxWidth="md">
                <Box sx={{ mb: 4 }}>
                    <Link component={RouterLink} to="/login" variant="body2">
                        ← Back to login
                    </Link>
                </Box>

                <Paper elevation={2} sx={{ p: { xs: 3, md: 5 }, borderRadius: 3 }}>
                    <Typography variant="h4" sx={{ fontWeight: 700 }} gutterBottom>
                        Privacy Policy
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                        Effective date: 2026-05-26 &nbsp;·&nbsp; Last updated: 2026-05-26
                    </Typography>

                    <Divider sx={{ my: 4 }} />

                    {/* ── Service identity ───────────────────────────────────── */}
                    <Section title="1. Name and Description of the Service">
                        <InfoRow label="Name" value="KNF Virtual Lab" />
                        <InfoRow
                            label="Description"
                            value="Cybersecurity virtual machine lab for VU KNF students."
                        />
                        <InfoRow
                            label="Service URL"
                            value={
                                <Link href="https://virtuallab.knf.vu.lt">
                                    virtuallab.knf.vu.lt
                                </Link>
                            }
                        />
                    </Section>

                    {/* ── Data controller ───────────────────────────────────── */}
                    <Section title="2. Data Controller and Contact">
                        <InfoRow
                            label="Organisation"
                            value="Vilnius University, Kaunas Faculty (KNF)"
                        />
                        <InfoRow
                            label="Address"
                            value="Muitinės g. 8, LT-44280 Kaunas, Lithuania"
                        />
                        <InfoRow
                            label="Contact"
                            value={
                                <Link href="mailto:admin@knf.vu.lt">
                                    admin@knf.vu.lt
                                </Link>
                            }
                        />
                        <InfoRow label="Jurisdiction" value="LT — Lithuania (EU)" />
                    </Section>

                    {/* ── Personal data processed ───────────────────────────── */}
                    <Section title="3. Personal Data Processed">
                        <Typography variant="subtitle2" gutterBottom>
                            A. Data requested from your Home Organisation (VU SSO)
                        </Typography>
                        <P>
                            The following attributes are requested from your Home Organisation
                            during login. The list matches the{" "}
                            <code>RequestedAttribute</code> elements in the service's SAML 2.0
                            metadata.
                        </P>
                        <BulletList
                            items={[
                                ["eduPersonTargetedID (required)", "An opaque, persistent, per-service identifier issued by VU SSO. Unique to this service only; does not reveal your username. Stored as your internal account key."],
                                ["cn (required)", "Your display name. Received but not stored."],
                                ["schacHomeOrganization (required)", "Your institution domain. Used to confirm VU affiliation; not stored."],
                                ["eduPersonAffiliation (optional)", "Your role at the institution (e.g. student, staff). Received but not stored."],
                                ["eduPersonPrincipalName (optional)", "Your scoped university username. Received but not stored."],
                                ["mail (optional)", "Your university e-mail address. Received but not stored."],
                            ]}
                        />

                        <Typography variant="subtitle2" gutterBottom>
                            B. Data gathered from your use of the service
                        </Typography>
                        <BulletList
                            items={[
                                ["Role", "Your assigned role in the lab (student or admin), set by KNF staff."],
                                ["Account creation date", "Timestamp of first login or manual account creation."],
                                ["Last login date", "Updated on every successful authentication."],
                                ["VM instance records", "Name, template, Proxmox VM ID, creation time, expiry time, and power state of virtual machines assigned to you."],
                                ["Session cookie", "A signed httpOnly JWT cookie, valid 24 hours, containing your account key and role. Not readable by JavaScript."],
                            ]}
                        />

                        <Typography variant="subtitle2" gutterBottom>
                            C. Data collected automatically by the service
                        </Typography>
                        <BulletList
                            items={[
                                ["Application logs", "Server-side logs may include your account identifier in the context of actions you perform (login events, VM start/stop, API calls). Used for security monitoring and troubleshooting. Retained for up to 90 days."],
                            ]}
                        />
                    </Section>

                    {/* ── Purpose ───────────────────────────────────────────── */}
                    <Section title="4. Purpose of the Processing">
                        <P>
                            Personal data is processed for the following purposes:
                        </P>
                        <BulletList
                            items={[
                                ["Authentication", "To verify that you are a VU student or staff member and to establish your session."],
                                ["Service delivery", "To associate virtual machine environments with your account and manage their lifecycle."],
                                ["Security and audit", "Application logs containing your account identifier are retained to detect abuse, troubleshoot failures, and maintain an audit trail. This includes login events and VM operations."],
                            ]}
                        />
                        <P>
                            The legal basis for processing is{" "}
                            <strong>legitimate interest</strong> (GDPR Art. 6(1)(f)) in
                            delivering a university teaching service, and{" "}
                            <strong>performance of a task in the public interest</strong>{" "}
                            (Art. 6(1)(e)) as part of Vilnius University's educational mission.
                        </P>
                    </Section>

                    {/* ── Third parties ─────────────────────────────────────── */}
                    <Section title="5. Third Parties">
                        <P>
                            Your data is processed only by the following internal systems,
                            all operated by KNF on infrastructure located within the{" "}
                            <strong>European Union (Lithuania)</strong>. No personal data is
                            transferred to parties outside Vilnius University or outside the
                            EU/EEA.
                        </P>
                        <BulletList
                            items={[
                                ["Proxmox VE", "Hypervisor that creates and manages virtual machines. Your account key is linked to any VM created for you."],
                                ["Apache Guacamole", "Browser-based console access to your VM. A Guacamole user account is created under your account key and deleted when your account is removed."],
                                ["Grafana Loki", "Log aggregation system. Retains application logs (including your account key) for up to 90 days. Accessible to KNF administrators only."],
                            ]}
                        />
                    </Section>

                    {/* ── Retention ─────────────────────────────────────────── */}
                    <Section title="6. Data Retention">
                        <BulletList
                            items={[
                                ["User account", "Deleted at the end of the academic year in which you last used the service, or immediately upon your request."],
                                ["VM instances", "Automatically deleted at the expiry time configured at creation, or immediately when manually deleted."],
                                ["Application logs", "Deleted after 90 days."],
                                ["Session cookie", "Expires 24 hours after issuance."],
                            ]}
                        />
                    </Section>

                    {/* ── Rights ────────────────────────────────────────────── */}
                    <Section title="7. How to Access, Rectify, and Delete Your Data">
                        <P>
                            To access, correct, or delete personal data held by this service,
                            contact{" "}
                            <Link href="mailto:admin@knf.vu.lt">admin@knf.vu.lt</Link>.
                            Requests will be handled within 30 days.
                        </P>
                        <P>
                            To rectify attributes released by your Home Organisation (such as
                            your name or affiliation), contact your{" "}
                            <strong>Home Organisation's IT helpdesk</strong> — this service
                            does not control the values sent by VU SSO.
                        </P>
                        <P>
                            Under the GDPR you also have the right to lodge a complaint with
                            the{" "}
                            <Link
                                href="https://vdai.lrv.lt"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                State Data Protection Inspectorate of Lithuania (VDAI)
                            </Link>
                            .
                        </P>
                    </Section>

                    {/* ── CoC ───────────────────────────────────────────────── */}
                    <Section title="8. Data Protection Code of Conduct">
                        <P>
                            Your personal data will be protected according to the{" "}
                            <Link
                                href="https://refeds.org/category/code-of-conduct/v2"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Code of Conduct for Service Providers
                            </Link>
                            , a common standard for the research and higher education sector
                            to protect your privacy.
                        </P>
                    </Section>

                    {/* ── Security ──────────────────────────────────────────── */}
                    <Section title="9. Security">
                        <P>
                            Passwords are stored as bcrypt hashes. SSO users have no
                            password stored. Session tokens are transmitted exclusively via
                            httpOnly, Secure, SameSite=Strict cookies. The service is
                            accessible only from Vilnius University network ranges.
                        </P>
                    </Section>

                    {/* ── Changes ───────────────────────────────────────────── */}
                    <Section title="10. Changes to This Policy">
                        <P>
                            Material changes will be communicated via the login page. The
                            effective date above reflects the most recent revision.
                        </P>
                    </Section>

                    <Divider sx={{ my: 3 }} />

                    <Typography variant="caption" color="text.disabled">
                        Questions? Contact{" "}
                        <Link href="mailto:admin@knf.vu.lt" variant="caption">
                            admin@knf.vu.lt
                        </Link>
                    </Typography>
                </Paper>
            </Container>
        </Box>
    );
}
