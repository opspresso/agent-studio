"use client";

import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Typography } from "@mantine/core";
import classes from "./MarkdownContent.module.css";

/** Shared answer rendering for stored messages and streamed replies. */
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const [origin, setOrigin] = useState<string>();
  useEffect(() => setOrigin(window.location.origin), []);
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, ...props }) => {
      if (!props.href) return <>{props.children}</>;
      const webUrl = /^(https?:)?\/\//i.test(props.href) && URL.canParse(props.href, origin)
        ? new URL(props.href, origin) : undefined;
      const internal = webUrl && webUrl.origin === origin;
      const href = internal ? `${webUrl.pathname}${webUrl.search}${webUrl.hash}` : props.href;
      const external = Boolean(webUrl && !internal);
      return <a {...props} href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} />;
    },
  }), [origin]);
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </Typography>
  );
});
