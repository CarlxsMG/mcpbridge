import type { CurrentUser } from "../../types/api";

export const DEMO_USER: NonNullable<CurrentUser["user"]> = { username: "demo", role: "admin" };
