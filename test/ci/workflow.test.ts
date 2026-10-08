import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/deploy.yml?raw";
import wranglerConfig from "../../wrangler.jsonc?raw";

// CI の定義と Cloudflare の設定が、仕様書 000 の約束どおりになっているかを確かめる。
describe("自動デプロイの定義", () => {
  const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));

  it("デプロイは、テストのジョブが成功したあとにだけ実行される", () => {
    expect(deployJob).toMatch(/\n {4}needs: test\n/);
  });

  it("デプロイは、main への push のときだけ実行される", () => {
    expect(deployJob).toMatch(
      /\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/,
    );
  });

  it("デプロイの前に、D1 のマイグレーションを適用する", () => {
    const migrate = deployJob.indexOf("wrangler d1 migrations apply DB --remote");
    const deploy = deployJob.indexOf("wrangler deploy");
    expect(migrate).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(migrate);
  });

  it("テストのジョブは、型チェック・lint・テスト・ビルドをすべて実行する", () => {
    const testJob = workflow.slice(workflow.indexOf("\n  test:"), workflow.indexOf("\n  deploy:"));
    for (const script of ["typecheck", "lint", "test", "build"]) {
      expect(testJob).toContain(`pnpm run ${script}`);
    }
  });
});

describe("公開 URL の設定", () => {
  it("独自ドメインだけで公開し、workers.dev とプレビュー用の URL は無効にする", () => {
    expect(wranglerConfig).toMatch(/"workers_dev": false/);
    expect(wranglerConfig).toMatch(/"preview_urls": false/);
    expect(wranglerConfig).toMatch(
      /"pattern": "movie-tracker\.tanijiri\.dev", "custom_domain": true/,
    );
  });
});
