import type { CatalogView } from "./CatalogView";
import { EmptyState, LoadingText } from "./PageState";
import classes from "./CatalogLayout.module.css";

/** Catalog pages own their entries; this boundary owns their shared display states. */
export function CatalogCollection({ view, loading, failed, empty, emptyText, children }: {
  view: CatalogView;
  loading: boolean;
  failed: boolean;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (loading) return <LoadingText />;
  if (failed) return null;
  if (empty) return <EmptyState>{emptyText}</EmptyState>;
  return <div className={classes.collection} data-view={view}>
    <div className={view === "grid" ? classes.grid : classes.list}>{children}</div>
  </div>;
}
