import { createLogmem as create } from "../src/server.mjs";

/** Test callers assert the space already bound to their LogMem connection. */
export function createLogmem(options) {
  const server = create(options);
  const call = server.callTool.bind(server);
  server.callTool = (name, args, callOptions) => {
    if (args == null) return call(name, args, callOptions);
    if (typeof args !== "object" || Array.isArray(args)) return call(name, args, callOptions);
    return call(name, {
      ...args,
      ...(Object.hasOwn(args, "targetSpace") ? {} : { targetSpace: options.space }),
    }, callOptions);
  };
  return server;
}
