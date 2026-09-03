// -----------------------------------------------------------
//  [*] Network adapters — the restricted SSH transport
//
//  One JSON request in, one JSON answer out, over an ssh
//  child process locked down as far as OpenSSH allows:
//  batch mode, pinned identity and known-hosts files,
//  strict host-key checking, no agent, no forwarding, no
//  local command. Timeouts and an output cap bound every
//  call; the far side is always a forced command.
//
//  Used by:
//    - access-clients.ts, gateway-clients.ts — every SSH
//      principal is one of these
//    - test/restricted-ssh.test.ts
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// RestrictedSshTransport
// -----------------------------------------------------------
//
// execute(request): spawn ssh, write the request to stdin,
// collect bounded output, parse the answer as JSON. The
// `finish` latch makes exactly one outcome win — close,
// error, timeout, output limit or stdin failure — whichever
// fires first.
//
// Used by:
//   - the Restricted* clients in access-apply.ts,
//     access-trunk-apply.ts, gateway-apply.ts and
//     adapters/access.ts / adapters/gateway.ts
// -----------------------------------------------------------

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
            // A stage request is far larger than the 64KB pipe buffer, so the
            // write below is still in flight when the child can die: a rotated
            // host key, a forced command rejecting an oversized request, or this
            // transport's own SIGKILL on timeout. Without a listener the
            // resulting EPIPE is an unhandled 'error' event on a Socket, which
            // terminates the whole backend for every user rather than failing
            // this one request.
            //
            // The write error itself is discarded: `close` always follows and
            // carries the exit code and stderr, which is the diagnosis worth
            // reporting. `finish()` makes whichever arrives first the winner.
            child.stdin.on("error", (error) => finish(() => {
                reject(new RestrictedSshError(
                    `Restricted SSH could not send the request: ${error.message}`,
                    "process-failed",
                ));
            }));
            child.stdin.end(`${JSON.stringify(request)}\n`);
        });
    }
}
