import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { runServer } from "./server";

runServer.pipe(NodeRuntime.runMain);
