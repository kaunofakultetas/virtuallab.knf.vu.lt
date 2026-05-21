import type { TokenPayload } from "@/types/auth";

declare global {
    namespace Express {
        interface Request {
            id?: string;
            user?: TokenPayload;
        }
    }
}

export {};
