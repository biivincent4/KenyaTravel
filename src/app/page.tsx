import TravelApp from "@/components/travel-app";
import { packages } from "@/lib/db";

export const dynamic = "force-dynamic";
export default function Home() {
  return <TravelApp initialPackages={packages()} />;
}
