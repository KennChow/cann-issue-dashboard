import type React from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  Legend,
} from "recharts";

const tooltipStyle: React.CSSProperties = {
  background: "rgba(15, 25, 45, 0.94)",
  border: "1px solid #385076",
  borderRadius: "8px",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.45)",
  fontSize: "12px",
  color: "#e2ecfc",
  padding: "8px 12px",
};

export function Chart({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section className="panel chart-panel">
      <h2>{title}</h2>
      <div className="chart">{children}</div>
      {note && <p className="muted chart-note">{note}</p>}
    </section>
  );
}

export function Bars({
  data,
  keys,
}: {
  data: Record<string, unknown>[];
  keys: { key: string; name: string; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          {keys.map((k) => (
            <linearGradient
              key={k.key}
              id={`bar-grad-${k.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={k.color} stopOpacity={0.95} />
              <stop offset="100%" stopColor={k.color} stopOpacity={0.45} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="#1e2d46" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="name"
          stroke="#8fa3bf"
          fontSize={11}
          interval={0}
          tickLine={false}
          axisLine={{ stroke: "#263652" }}
        />
        <YAxis
          stroke="#8fa3bf"
          fontSize={11}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "rgba(101, 179, 255, 0.06)" }}
          contentStyle={tooltipStyle}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: "12px", paddingTop: "6px" }} />
        {keys.map((k) => (
          <Bar
            isAnimationActive={false}
            key={k.key}
            dataKey={k.key}
            name={k.name}
            fill={`url(#bar-grad-${k.key})`}
            stroke={k.color}
            strokeWidth={1}
            radius={[6, 6, 0, 0]}
            maxBarSize={44}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Lines({
  data,
  keys,
}: {
  data: Record<string, unknown>[];
  keys: { key: string; name: string; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid stroke="#1e2d46" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          stroke="#8fa3bf"
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "#263652" }}
        />
        <YAxis
          stroke="#8fa3bf"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: "12px", paddingTop: "6px" }} />
        {keys.map((k) => (
          <Line
            isAnimationActive={false}
            type="monotone"
            key={k.key}
            dataKey={k.key}
            name={k.name}
            stroke={k.color}
            strokeWidth={2.5}
            dot={data.length < 3 ? { r: 4, fill: k.color } : false}
            activeDot={{ r: 5, strokeWidth: 0, fill: k.color }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
