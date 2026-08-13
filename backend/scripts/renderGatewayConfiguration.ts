import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGatewayPlan, GatewayDesiredStateInput } from "@/network/gateway-desired-state";
import { renderGatewayConfiguration } from "@/network/gateway-render";

async function writeBundle(
    outputDirectory: string,
    rendered: ReturnType<typeof renderGatewayConfiguration>,
): Promise<void> {
    const files = {
        ...rendered.files.networkd,
        "/etc/sysctl.d/99-virtual-lab-gateway.conf": rendered.files.sysctl,
        "/etc/nftables.d/virtual-lab-gateway.nft": rendered.files.nftables,
        "/etc/dnsmasq.d/virtual-lab-gateway.conf": rendered.files.dnsmasq,
        // A complete squid.conf, not a conf.d fragment. The stock Ubuntu config
        // already binds http_port 3128 and defines Safe_ports, and Squid appends
        // rather than replaces both, so a fragment would fail to bind and would
        // silently widen the port restriction.
        "/etc/squid/squid.conf": rendered.files.squid,
    };
    const manifest: Record<string, string> = {};
    for (const [absolutePath, content] of Object.entries(files).sort(
        ([left], [right]) => left.localeCompare(right),
    )) {
        const relativePath = absolutePath.replace(/^\//, "");
        const outputPath = path.join(outputDirectory, "rootfs", relativePath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, { encoding: "utf8", mode: 0o644 });
        manifest[absolutePath] = createHash("sha256").update(content).digest("hex");
    }
    await writeFile(
        path.join(outputDirectory, "manifest.json"),
        `${JSON.stringify({ revision: rendered.revision, files: manifest }, null, 2)}\n`,
        "utf8",
    );
}

async function main(): Promise<void> {
    const inputPath = process.argv[2];
    if (!inputPath) {
        throw new Error(
            "Usage: npm run render-gateway -- <desired-state-input.json> [--output-dir <directory>]",
        );
    }

    const outputDirectory = process.argv[3] === "--output-dir" ? process.argv[4] : undefined;
    if (process.argv.length > 3 && !outputDirectory) {
        throw new Error("Expected --output-dir <directory>");
    }

    const input = JSON.parse(
        await readFile(inputPath, "utf8"),
    ) as GatewayDesiredStateInput;
    const rendered = renderGatewayConfiguration(buildGatewayPlan(input));
    if (outputDirectory) {
        await mkdir(outputDirectory, { recursive: true });
        await writeBundle(outputDirectory, rendered);
        process.stdout.write(`${rendered.revision}\n`);
    } else {
        process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
