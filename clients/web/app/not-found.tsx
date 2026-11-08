import { AuthShell } from '../src/auth/screens/AuthShell';
import { AuthLink } from '../src/ui';

export default function NotFound() {
  return (
    <AuthShell
      title="Nothing here"
      lead="That page does not exist, or this instance does not offer it."
      footer={<AuthLink href="/">Go to the start page</AuthLink>}
      footerAlign="start"
    />
  );
}
