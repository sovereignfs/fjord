import { site } from "../src/site";

export default function Home() {
  return (
    <main>
      <h1>{site.name}</h1>
      <p>{site.tagline}</p>
      <p>{site.status}</p>
    </main>
  );
}
