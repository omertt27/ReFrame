type CardProps = {
  title: string;
};

export default function Card({ title }: CardProps) {
  return (
    <div className="rounded-2xl border border-slate-200 p-6 shadow-sm">
      <h3 className="text-lg font-semibold">{title}</h3>
    </div>
  );
}
