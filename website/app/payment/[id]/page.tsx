import { TestPaymentNotice } from "@/components/environment-banner";
import { LIVE_APP_PACKAGE, TEST_APP_PACKAGE } from "@/lib/app-packages";
import { currentEnvironment } from "@/lib/environment";
import PaymentStatus from "./payment-status";
export default async function Page({params}: {params:Promise<{id:string}>}) {
  const {id}=await params;
  const appPackage = currentEnvironment() === "test" ? TEST_APP_PACKAGE : LIVE_APP_PACKAGE;
  return <><TestPaymentNotice /><PaymentStatus id={id} appPackage={appPackage}/></>;
}
