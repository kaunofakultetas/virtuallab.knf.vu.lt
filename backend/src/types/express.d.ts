// -----------------------------------------------------------
//  [*] Types — Express request augmentation
//
//  Adds the fields our middleware hangs on every request:
//  `id` (request-id.middleware.ts) and `user`
//  (auth.middleware.ts). Ambient — nothing imports this
//  file; tsconfig picks it up.
// -----------------------------------------------------------

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
