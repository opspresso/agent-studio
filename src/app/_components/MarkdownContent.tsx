"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Typography } from "@mantine/core";
import classes from "./MarkdownContent.module.css";

/** Shared answer rendering for stored messages and streamed replies. */
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </Typography>
  );
});
