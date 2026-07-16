import type { Request, Response, NextFunction } from "express";
import { getClientTeam, canAccessClient, getConsumerTeam, canAccessConsumer } from "../admin/entities/teams.js";
import { notFound, forbidden } from "../routes/http-errors.js";

/** The caller's tenancy scope: a team id, null for a super-admin session, or undefined for a bearer caller (super-admin). */
export function callerTeamId(req: Request): number | null | undefined {
  return req.authContext?.method === "session" ? (req.authContext.teamId ?? null) : undefined;
}

/**
 * Tenancy guard for a single-client route. Returns true when the caller may act
 * on the client (or the client doesn't exist — the route's own 404 handles
 * that). When it returns false it has already written a 404 with the same shape
 * as "client not found", so a scoped caller can't even distinguish existence.
 */
export function ensureClientAccess(req: Request, res: Response, clientName: string): boolean {
  const clientTeam = getClientTeam(clientName);
  if (clientTeam === undefined) return true; // unknown client — let the handler 404 normally
  if (canAccessClient(callerTeamId(req), clientTeam)) return true;
  notFound(res, "CLIENT_NOT_FOUND", "Client not found");
  return false;
}

/**
 * Non-response-writing tenancy check for bulk loops, where `ensureClientAccess`
 * can't be used because it would write a 404 mid-iteration. Returns true when
 * the caller may act on this client, or the client is unknown (the per-name
 * result then reports it as not-found normally).
 */
export function canCallerAccessClient(req: Request, clientName: string): boolean {
  const clientTeam = getClientTeam(clientName);
  if (clientTeam === undefined) return true; // unknown client — handled as not-found by the caller
  return canAccessClient(callerTeamId(req), clientTeam);
}

/**
 * Tenancy guard for a single-consumer route — same contract as
 * ensureClientAccess: true when the caller may act on the consumer (or the
 * consumer doesn't exist, letting the route's own 404 handle that);
 * otherwise writes a 404 identical to "consumer not found" so a scoped
 * caller can't distinguish existence.
 */
export function ensureConsumerAccess(req: Request, res: Response, consumerId: number): boolean {
  const consumerTeam = getConsumerTeam(consumerId);
  if (consumerTeam === undefined) return true; // unknown consumer — let the handler 404 normally
  if (canAccessConsumer(callerTeamId(req), consumerTeam)) return true;
  notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
  return false;
}

/** Admin-only for session callers (viewer/operator/auditor are rejected). Bearer callers always pass. */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (req.authContext?.method === "session" && req.authContext.role !== "admin") {
    forbidden(res, "FORBIDDEN", "This action requires the admin role");
    return;
  }
  next();
}

/** True for a bearer caller or a super-admin session (admin role + no team) — false for any other session. */
export function isSuperAdminCaller(req: Request): boolean {
  return (
    req.authContext?.method !== "session" ||
    (req.authContext.role === "admin" && (req.authContext.teamId ?? null) === null)
  );
}

/** Tenancy administration: only a super-admin session (admin role + no team) passes. Bearer callers always pass. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isSuperAdminCaller(req)) {
    forbidden(res, "FORBIDDEN", "This action requires a super-admin (admin role, no team)");
    return;
  }
  next();
}

/** Operational mutations: admin + operator sessions pass; auditor/viewer are rejected. Bearer callers always pass. */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (
    req.authContext?.method === "session" &&
    req.authContext.role !== "admin" &&
    req.authContext.role !== "operator"
  ) {
    forbidden(res, "FORBIDDEN", "This action requires the admin or operator role");
    return;
  }
  next();
}
