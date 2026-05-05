export type UserRole = "admin" | "student";

export interface TokenPayload {
  vu_id: string;
  role: UserRole;
}

export interface User {
  vu_id: string;
  role: UserRole;
}

export interface ExtendedUser extends User {
  last_login: Date;
  created_at: Date;
}
