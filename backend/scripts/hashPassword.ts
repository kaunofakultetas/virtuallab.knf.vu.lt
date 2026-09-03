// -----------------------------------------------------------
//  [*] Scripts — hash-password (operator CLI)
//
//  Prints a bcrypt hash for a password — for seeding or
//  fixing user rows by hand. Invalid --rounds values fall
//  back to 10 silently rather than erroring.
//
//  Usage:
//    npm run hash-password -- --password <pw> [--rounds 10]
// -----------------------------------------------------------

import bcrypt from "bcryptjs";

type Args = {
    password: string;
    rounds: number;
};


function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let password = "";
    let rounds = 10;
    const positionals: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--password" || arg === "-p") {
            password = argv[i + 1] ?? "";
            i++;
            continue;
        }

        if (arg === "--rounds" || arg === "-r") {
            const parsed = Number(argv[i + 1]);
            if (Number.isInteger(parsed) && parsed >= 4 && parsed <= 31) {
                rounds = parsed;
            }
            i++;
            continue;
        }

        positionals.push(arg);
    }

    if (!password && positionals[0]) {
        password = positionals[0];
    }

    if (!password) {
        throw new Error(
            "Usage: npm run hash-password -- --password <password> [--rounds 10]",
        );
    }

    return { password, rounds };
}


async function main() {
    const { password, rounds } = parseArgs();
    const hash = await bcrypt.hash(password, rounds);
    console.log(hash);
}


void main().catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
});
