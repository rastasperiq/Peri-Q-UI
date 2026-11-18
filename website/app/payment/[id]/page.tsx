import { TestPaymentNotice } from "@/components/environment-banner";
import PaymentStatus from "./payment-status";
export default async function Page({params}: {params:Promise<{id:string}>}) { const {id}=await params; return <><TestPaymentNotice /><PaymentStatus id={id}/></>; }
