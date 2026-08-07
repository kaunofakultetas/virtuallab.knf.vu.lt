import { spawn } from "node:child_process";

export type RestrictedSshConfig = {
    host: string;
    port?: number;
    hostKeyAlias?: string;
    user: string;
    identityFile: string;
    knownHostsFile: string;
    remoteCommand: string;
    executable?: string;
    executableArgs?: string[];
    connectTimeoutSeconds?: number;
    executionTimeoutMs?: number;
    maxOutputBytes?: number;
};

export class RestrictedSshError extends Error {
    constructor(
        message: string,
        readonly code: "timeout" | "output-limit" | "process-failed",
    ) {
        super(message);
        this.name = "RestrictedSshError";
    }
}

export class RestrictedSshTransport {
    constructor(private readonly config: RestrictedSshConfig) {}

    async execute(request: unknown): Promise<unknown> {
        const executable = this.config.executable ?? "ssh";
        const maxOutputBytes = this.config.maxOutputBytes ?? 64 * 1024;
        const args = [
            "-T",
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${this.config.knownHostsFile}`,
            ...(this.config.hostKeyAlias ? ["-o", `HostKeyAlias=${this.config.hostKeyAlias}`] : []),
            "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes",
            "-o", "PermitLocalCommand=no",
            "-o", `ConnectTimeout=${this.config.connectTimeoutSeconds ?? 5}`,
            "-p", String(this.config.port ?? 22),
            "-i", this.config.identityFile,
            `${this.config.user}@${this.config.host}`,
            this.config.remoteCommand,
        ];

        return new Promise((resolve, reject) => {
            const child = spawn(executable, [...(this.config.executableArgs ?? []), ...args], {
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const rejectForLimit = () => finish(() => {
                child.kill("SIGKILL");
                reject(new RestrictedSshError("Restricted SSH output exceeded the configured limit", "output-limit"));
            });
            const collect = (target: Buffer[]) => (chunk: Buffer) => {
                outputBytes += chunk.length;
                if (outputBytes > maxOutputBytes) {
                    rejectForLimit();
                    return;
                }
                target.push(chunk);
            };
            child.stdout.on("data", collect(stdout));
            child.stderr.on("data", collect(stderr));
            child.on("error", (error) => finish(() => reject(new RestrictedSshError(
                `Restricted SSH process failed: ${error.message}`,
                "process-failed",
            ))));
            child.on("close", (exitCode) => finish(() => {
                if (exitCode !== 0) {
                    const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
                    reject(new RestrictedSshError(
                        `Restricted SSH exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
                        "process-failed",
                    ));
                    return;
                }
                const output = Buffer.concat(stdout).toString("utf8").trim();
                try {
                    resolve(JSON.parse(output));
                } catch {
                    reject(new RestrictedSshError(
                        "Restricted SSH returned invalid JSON",
                        "process-failed",
                    ));
                }
            }));
            const timer = setTimeout(() => finish(() => {
                child.kill("SIGKILL");
                reject(new RestrictedSshError("Restricted SSH execution timed out", "timeout"));
            }), this.config.executionTimeoutMs ?? 15_000);
            timer.unref();
            child.stdin.end(`${JSON.stringify(request)}\n`);
        });
    }
}