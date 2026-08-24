import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digital Democracy",
  description: "Continuous citizen participation in governance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
