import { getSessionUser } from "@/lib/session";
import { Overview } from "./_components/Overview";
import { LandingPage } from "./_components/landing/LandingPage";

export default async function Home() {
  const user = await getSessionUser();
  return user
    ? <Overview userEmail={user.email} tier={user.tier} />
    : <LandingPage />;
}
