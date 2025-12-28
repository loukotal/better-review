import { Context, Effect } from "effect";

interface GhCli {}

class GhService extends Context.Tag("GHService")<GhService, GhCli>() {}
