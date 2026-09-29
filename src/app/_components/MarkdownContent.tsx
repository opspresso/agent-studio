"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Typography } from "@mantine/core";
import classes from "./MarkdownContent.module.css";

const components: Components = {
  a: ({ node: _node, ...props }) => props.href ? <a {...props} /> : <>{props.children}</>,
};

/** Shared answer rendering for stored messages and streamed replies. */
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </Typography>
  );
});
