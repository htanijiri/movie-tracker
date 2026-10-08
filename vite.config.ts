import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    // Google ログインのリダイレクト先（http://localhost:5183/auth/google/callback）を
    // Google 側に登録しているので、ポートを固定する。空いていなければ起動を失敗させる。
    // Vite の既定の 5173 は、ほかのプロジェクトの開発サーバーとぶつかるので使わない。
    port: 5183,
    strictPort: true,
  },
});
