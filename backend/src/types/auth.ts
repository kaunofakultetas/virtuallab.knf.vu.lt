// -----------------------------------------------------------
//  [*] Types — authentication
//
//  The two roles, the JWT payload, and the user shapes. The
//  vu_id is the primary identity everywhere — users have no
//  separate numeric ID.
//
//  Used by:
//    - auth.middleware.ts — TokenPayload on req.user
//    - auth.route.ts, users.controller.ts
// -----------------------------------------------------------

export type UserRole = "admin" | "student";

// What jwt.sign puts in the cookie and jwt.verify hands back.
export interface TokenPayload {
    vu_id: string;
    role: UserRole;
}

export interface User {
    vu_id: string;
    role: UserRole;
}

// The admin listing shape — User plus the audit columns.
export interface ExtendedUser extends User {
    last_login: Date;
    created_at: Date;
}
