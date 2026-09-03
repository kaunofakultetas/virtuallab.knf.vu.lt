// -----------------------------------------------------------
//  [*] Types — users (API shapes)
//
//  The bulk-create request/response mirror POST /auth/users:
//  one result per requested user, with a generated password
//  present only when the server generated one.
//
//  Used by:
//    - pages/admin/Users.tsx
// -----------------------------------------------------------

export interface User {
    vu_id: string;
    role?: string;
    password?: string;
    last_login?: string;
}

export interface CreateUserRequest {
    users: {
        vu_id: string;
        password?: string;
    }[];
}

export interface CreateUserResponse {
    vu_id: string;
    success: boolean;
    data?: {
        vu_id: string;
        role?: string;
        password?: string;
    };
}
