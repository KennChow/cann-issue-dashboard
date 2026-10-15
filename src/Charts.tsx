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
    <section className="panel">
      <h2>{title}</h2>
      <div className="chart">{children}</div>
      {note && <p className="muted">{note}</p>}
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
      <BarChart data={data}>
        <CartesianGrid stroke="#24324b" vertical={false} />
        <XAxis dataKey="name" stroke="#91a0b9" fontSize={11} interval={0} />
        <YAxis stroke="#91a0b9" fontSize={11} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: "#152139", border: "1px solid #344766" }}
        />
        <Legend />
        {keys.map((k) => (
          <Bar
            isAnimationActive={false}
            key={k.key}
            dataKey={k.key}
            name={k.name}
            fill={k.color}
            radius={[4, 4, 0, 0]}
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
      <LineChart data={data}>
        <CartesianGrid stroke="#24324b" vertical={false} />
        <XAxis dataKey="date" stroke="#91a0b9" fontSize={11} />
        <YAxis stroke="#91a0b9" fontSize={11} />
        <Tooltip
          contentStyle={{ background: "#152139", border: "1px solid #344766" }}
        />
        <Legend />
        {keys.map((k) => (
          <Line
            isAnimationActive={false}
            type="monotone"
            key={k.key}
            dataKey={k.key}
            name={k.name}
            stroke={k.color}
            dot={data.length < 3}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
