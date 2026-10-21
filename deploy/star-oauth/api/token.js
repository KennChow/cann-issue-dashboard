// Vercel Function：POST /api/token
import { handle } from "../handler.js";

const run = (request) => handle(request, process.env);

export const POST = run;
export const OPTIONS = run;
export const GET = run;
