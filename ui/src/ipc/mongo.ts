// The `ipc.mongo` namespace. The Rust-aligned core surface (1:1 with the `mongo_*` commands, see mongoCore.ts) is the
// default; the UI module may extend it here with its own view-level methods.
import { createTauriMongoCore, type MongoCoreIpc } from "./mongoCore";

export * from "./mongoCore";
export type MongoIpc = MongoCoreIpc;
export const createTauriMongo = createTauriMongoCore;
