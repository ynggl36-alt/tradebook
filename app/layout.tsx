import type { Metadata } from "next";
import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  title: "Tradebook — 2026 trading journal",
  description: "Your private 2026 trading history, account performance and cash flow in one place.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head><meta name="theme-color" content="#0f171b"/><script dangerouslySetInnerHTML={{__html:"try{var t=localStorage.getItem('tradebook-theme')==='light'?'light':'dark';document.documentElement.dataset.theme=t;document.querySelector('meta[name=theme-color]').setAttribute('content',t==='dark'?'#0f171b':'#f6f7f2')}catch(e){}"}}/></head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
