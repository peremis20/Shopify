"use client";

/** Three steps to let the autopilot make WordPress changes itself instead of a fix list. */
export function WordPressConnect({ domain }: { domain: string }) {
  const admin = `https://${domain}/wp-admin`;
  return (
    <div className="space-y-2 rounded-xl border border-dash-green/30 bg-dash-green/5 p-4 text-sm">
      <p>
        <b>Your site runs on WordPress.</b> Install our small plugin and the autopilot makes each improvement for you, with undo,
        instead of a fix list. About two minutes:
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <a href="/api/wordpress/plugin" className="font-semibold text-dash-green hover:underline">
            Download the Insights Connector plugin
          </a>{" "}
          (a .zip file; don&apos;t unzip it).
        </li>
        <li>
          In WordPress,{" "}
          <a href={`${admin}/plugin-install.php?tab=upload`} target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
            open Plugins, Add New, Upload Plugin
          </a>
          , choose the file, click Install Now, then Activate.
        </li>
        <li>
          Go to{" "}
          <a href={`${admin}/options-general.php?page=insights-connector`} target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
            Settings, Insights
          </a>{" "}
          and click <b>Connect to Insights</b>. You come straight back here.
        </li>
      </ol>
      <p className="text-dash-muted">Works with Yoast SEO, Rank Math, SEOPress, All in One SEO, or no SEO plugin.</p>
    </div>
  );
}
