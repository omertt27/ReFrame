type NavbarProps = {
  variant: string;
};

export default function Navbar({ variant }: NavbarProps) {
  return (
    <header
      className={
        variant === "transparent"
          ? "absolute top-0 left-0 right-0 h-16 bg-transparent text-white"
          : "sticky top-0 h-16 bg-white text-slate-900 shadow-sm"
      }
    >
      <a href="/">ReFrame Test Co.</a>
    </header>
  );
}
