import { Table } from "@mantine/core";

/**
 * A table of numbers, with its scroll container — the single owner of how
 * dense a usage table is and how it overflows.
 *
 * The three cost surfaces had disagreed on both: the overview used
 * `sm`/`lg` inside a `ScrollArea` with a `miw`, the project usage and profile
 * pages `xs`/`md` inside a `Table.ScrollContainer`. Same columns, same
 * numbers, three different row heights. `sm` vertical because the overview's
 * rows carry a progress bar under the name and `xs` crushes them; `md`
 * horizontal because the columns are narrow and `lg` spends the width a
 * model id needs.
 *
 * Children are the `Table.Thead` / `Tbody` / `Tfoot` the caller writes, so
 * this constrains the frame without owning the columns.
 */
export function DataTable({
  minWidth = 420,
  children,
}: {
  minWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <Table.ScrollContainer minWidth={minWidth}>
      <Table verticalSpacing="sm" horizontalSpacing="md">
        {children}
      </Table>
    </Table.ScrollContainer>
  );
}
