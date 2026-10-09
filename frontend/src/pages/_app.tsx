import type { AppProps } from "next/app";
import { Cormorant_Garamond, Jost } from "next/font/google";
import "@/styles/globals.css";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
});
const jost = Jost({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--font-jost" });

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${cormorant.variable} ${jost.variable} font-sans`}>
      <Component {...pageProps} />
    </div>
  );
}
