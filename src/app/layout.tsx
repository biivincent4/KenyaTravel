import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sanaa Kenya | A journey that's yours",
  description:
    "Discover Kenya, shape a personal itinerary, and plan your next adventure with a local travel agency. Provisional MVP brand.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
