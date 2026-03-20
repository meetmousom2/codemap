import type { User, Config } from "./types";

/** Log levels */
export const enum LogLevel {
  Debug = "debug",
  Info = "info",
  Error = "error",
}

/** Base service class */
export abstract class BaseService {
  protected config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

/** User service for managing users */
export class UserService extends BaseService {
  private users: Map<string, User> = new Map();

  /** Get a user by ID */
  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  /** Create a new user */
  async createUser(name: string, email?: string): Promise<User> {
    const user: User = { id: crypto.randomUUID(), name, email };
    this.users.set(user.id, user);
    return user;
  }

  async start(): Promise<void> {
    // init
  }

  async stop(): Promise<void> {
    this.users.clear();
  }
}

/** Helper function to validate email */
export function validateEmail(email: string): boolean {
  return email.includes("@");
}

/** App version */
export const APP_VERSION = "2.0.0";
