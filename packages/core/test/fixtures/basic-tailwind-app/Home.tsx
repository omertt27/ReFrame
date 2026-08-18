import Navbar from "./Navbar";
import Hero from "./Hero";
import Card from "./Card";
import Button from "./Button";
import Footer from "./Footer";

export default function Home() {
  return (
    <>
      <Navbar variant="transparent" />
      <Hero />
      <Card title="Direct edit" />
      <Button active={false} />
      <Footer />
    </>
  );
}
