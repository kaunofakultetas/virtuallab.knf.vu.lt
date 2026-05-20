export interface User {
    vu_id: string;
    role?: string;
    password?: string;
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
