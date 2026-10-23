// The fake Sovereign (src/auth/testing/fake-sovereign.ts) as a process of its own, for the
// browser tests: the OIDC provider on 3190, and on 3191 a control port, where a test says who
// the next person to sign in is (POST /sign-in-as, a JSON user) and which the webServer
// waits on (GET /health). Run by playwright.config.ts; node strips the types itself.
import { createServer } from "node:http";
import { startFakeSovereign } from "../src/auth/testing/fake-sovereign.ts";

const fake = await startFakeSovereign({ port: 3190, clientId: "fjord-e2e-client", clientSecret: "fjord-e2e-secret" });

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/sign-in-as") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      fake.signInAs(JSON.parse(body));
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(3191, () => console.log(`fake Sovereign at ${fake.issuer}`));
