import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ZERORE Eval Console",
  description: "对话评估 MVP 工作台，覆盖 raw -> enriched -> presentation 的完整链路。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={geistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
