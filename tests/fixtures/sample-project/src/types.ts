/** A user in the system */
export interface User {
  id: string;
  name: string;
  email?: string;
}

/** Extended user with role */
export interface AdminUser extends User {
  role: "admin" | "superadmin";
  permissions: string[];
}

/** Configuration options */
export type Config = {
  host: string;
  port: number;
  debug: boolean;
};

/** Status union type */
export type Status = "active" | "inactive" | "pending";
