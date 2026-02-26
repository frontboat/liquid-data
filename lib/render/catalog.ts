import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

/**
 * Data Explorer Catalog — focused on data visualization components.
 * No 3D scene components (not needed for data exploration).
 */
export const explorerCatalog = defineCatalog(schema, {
  components: {
    Stack: shadcnComponentDefinitions.Stack,
    Card: shadcnComponentDefinitions.Card,
    Grid: shadcnComponentDefinitions.Grid,
    Heading: shadcnComponentDefinitions.Heading,
    Separator: shadcnComponentDefinitions.Separator,
    Accordion: shadcnComponentDefinitions.Accordion,
    Progress: shadcnComponentDefinitions.Progress,
    Skeleton: shadcnComponentDefinitions.Skeleton,
    Badge: shadcnComponentDefinitions.Badge,
    Alert: shadcnComponentDefinitions.Alert,

    Text: {
      props: z.object({
        content: z.string(),
        muted: z.boolean().nullable(),
      }),
      description: "Text content",
      example: { content: "Here is your data overview." },
    },

    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string().nullable(),
        trend: z.enum(["up", "down", "neutral"]).nullable(),
      }),
      description: "Single metric display with label, value, and optional trend indicator",
      example: { label: "Total Rows", value: "1,234", detail: "After filtering", trend: "up" },
    },

    Table: {
      props: z.object({
        data: z.array(z.record(z.string(), z.unknown())),
        columns: z.array(z.object({ key: z.string(), label: z.string() })),
        emptyMessage: z.string().nullable(),
      }),
      description: 'Data table. Use { "$state": "/path" } to bind read-only data from state.',
      example: { data: { $state: "/results" }, columns: [{ key: "name", label: "Name" }, { key: "value", label: "Value" }] },
    },

    Link: {
      props: z.object({ text: z.string(), href: z.string() }),
      description: "External link that opens in a new tab",
    },

    BarChart: {
      props: z.object({
        title: z.string().nullable(),
        data: z.array(z.record(z.string(), z.unknown())),
        xKey: z.string(),
        yKey: z.string(),
        aggregate: z.enum(["sum", "count", "avg"]).nullable(),
        color: z.string().nullable(),
        height: z.number().nullable(),
      }),
      description: 'Bar chart visualization. Use { "$state": "/path" } to bind data.',
    },

    LineChart: {
      props: z.object({
        title: z.string().nullable(),
        data: z.array(z.record(z.string(), z.unknown())),
        xKey: z.string(),
        yKey: z.string(),
        aggregate: z.enum(["sum", "count", "avg"]).nullable(),
        color: z.string().nullable(),
        height: z.number().nullable(),
      }),
      description: 'Line chart visualization. Use { "$state": "/path" } to bind data.',
    },

    PieChart: {
      props: z.object({
        title: z.string().nullable(),
        data: z.array(z.record(z.string(), z.unknown())),
        nameKey: z.string(),
        valueKey: z.string(),
        height: z.number().nullable(),
      }),
      description: 'Pie/donut chart for proportional data. Use { "$state": "/path" } to bind data.',
    },

    Tabs: {
      props: z.object({
        defaultValue: z.string().nullable(),
        tabs: z.array(z.object({ value: z.string(), label: z.string() })),
      }),
      slots: ["default"],
      description: "Tabbed content container",
    },

    TabContent: {
      props: z.object({ value: z.string() }),
      slots: ["default"],
      description: "Content for a specific tab",
    },

    Callout: {
      props: z.object({
        type: z.enum(["info", "tip", "warning", "important"]).nullable(),
        title: z.string().nullable(),
        content: z.string(),
      }),
      description: "Highlighted callout box for tips, warnings, notes, or key information",
    },

    Timeline: {
      props: z.object({
        items: z.array(z.object({
          title: z.string(),
          description: z.string().nullable(),
          date: z.string().nullable(),
          status: z.enum(["completed", "current", "upcoming"]).nullable(),
        })),
      }),
      description: "Vertical timeline showing ordered events or steps",
    },

    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["default", "secondary", "destructive", "outline", "ghost"]).nullable(),
        size: z.enum(["default", "sm", "lg"]).nullable(),
        disabled: z.boolean().nullable(),
      }),
      description: "Clickable button. Use with on.press to trigger actions.",
    },
  },

  actions: {},
});
