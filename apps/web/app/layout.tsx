import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";

import "./globals.css";
import { PwaRegister } from "../components/pwa-register";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-main"
});

export const metadata: Metadata = {
  title: "LoveChat",
  description: "Private encrypted messenger",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/icon.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={spaceGrotesk.variable}>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
