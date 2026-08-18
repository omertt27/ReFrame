import clsx from "clsx";

type ButtonProps = {
  active: boolean;
};

export default function Button({ active }: ButtonProps) {
  return (
    <button
      className={clsx("rounded-full px-4 py-2 text-sm font-medium", active && "bg-slate-900 text-white")}
    >
      Click me
    </button>
  );
}
