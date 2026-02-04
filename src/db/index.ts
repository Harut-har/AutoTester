import Database from "better-sqlite3";
import path from "node:path";
import { schemaSql } from "./schema.js";

let db: Database.Database | null = null;

function resolveDbPath(): string {
  const envPath = process.env.AUTOTESTER_DB;
  if (envPath && envPath.trim().length > 0) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.resolve(process.cwd(), "autotester.sqlite");
}

export function initDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("foreign_keys = ON");
  db.exec(schemaSql);
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("DB not initialized. Call initDb() first.");
  }
  return db;
}
