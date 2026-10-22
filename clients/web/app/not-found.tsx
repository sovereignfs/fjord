import { AuthShell } from "../src/auth/screens/AuthShell";

export default function NotFound() {
  return (
    <AuthShell title="Nothing here" lead="That page does not exist, or this instance does not offer it.">
      <a href="/">Go to the start page</a>
    </AuthShell>
  );
}
