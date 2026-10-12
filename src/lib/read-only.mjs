// read-only.mjs — wrap a Redis runner so only read commands get through.
// Used by the migration dry run and the scorecard endpoint (which holds
// read-write creds but must never write).

export const READ_COMMANDS = new Set(["PING", "DBSIZE", "SCAN", "TYPE", "GET", "HGET", "HGETALL", "SMEMBERS", "LRANGE", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZCARD", "EXISTS", "TTL"]);

export function readOnly(redis, { retries = 4 } = {}) {
  return async (cmd, ...args) => {
    const c = String(cmd).toUpperCase();
    if (!READ_COMMANDS.has(c)) throw new Error(`read-only guard: ${c} is not a read command`);
    for (let attempt = 0; ; attempt++) {
      try {
        return await redis(c, ...args);
      } catch (e) {
        if (attempt >= retries) throw e;
        await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
      }
    }
  };
}
