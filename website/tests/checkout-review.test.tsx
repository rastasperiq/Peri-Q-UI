import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import CheckoutClient from "../app/checkout/checkout-client";
import { siteConfig } from "../lib/site";

const item = { id: "plate", name: "Pork Plate", description: "", price: 45, category: "Meals", imagePath: "", isAvailable: true, prepMinutes: 20, spiceLevels: ["Hot"], addOns: [{ name: "Cheese", price: 5 }] };
const entries = [{ id: "line-1", item, quantity: 2, spiceLevel: "Hot", notes: "No onions", selectedAddOns: [{ name: "Cheese", price: 5 }] }];

vi.mock("@/lib/cart", () => ({ useCart: () => ({ entries, subtotal: 100, clear: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({ ensureAnonSession: async () => ({ accessToken: "tok", userId: "anon-1" }) }));
vi.mock("@/lib/policy-consent", () => ({ recordCheckoutAcceptance: vi.fn() }));
vi.mock("@/lib/customer-auth", () => ({ useCustomerAuth: () => ({ user: null, profile: null }) }));
vi.mock("@/lib/supabase", () => ({ isSupabaseConfigured: () => true, createBrowserClient: vi.fn() }));
vi.mock("@/lib/menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/menu")>()),
  fetchMenu: async () => ({ items: [], categories: [], appSettings: { storeOpen: true, pickupAvailable: true, deliveryAvailable: true, deliveryFee: 30, deliveryBaseFee: 15, deliveryPricePerKm: 4, deliveryMinFee: 20, deliveryMaxDistanceKm: 15, deliveryFreeThreshold: null, openingTime: "00:00", closingTime: "00:00" } }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true, mode: "test" }))));
  localStorage.clear();
});

describe("Checkout review (ECTA section 44)", () => {
  it("shows every item with its options, the charges and where the order goes, before payment", async () => {
    render(<CheckoutClient />);
    const review = (await screen.findByRole("heading", { name: "Review your order" })).closest("aside")!;
    const scope = within(review);
    expect(scope.getByText("Pork Plate")).toBeInTheDocument();
    expect(scope.getByText("×2")).toBeInTheDocument();
    expect(scope.getByText("Hot")).toBeInTheDocument();
    expect(scope.getByText("+ Cheese (R5.00)")).toBeInTheDocument();
    expect(scope.getByText("Note: No onions")).toBeInTheDocument();
    expect(scope.getByText("Total to pay now")).toBeInTheDocument();
    expect(scope.getByText(siteConfig.address)).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Edit cart" }).getAttribute("href")).toMatch(/^\/cart\/?$/);
    expect(scope.getByRole("link", { name: "Cancellations and refunds" }).getAttribute("href")).toMatch(/^\/terms-and-conditions\/?$/);
  });

  it("repeats the delivery address and contact details as they are typed", async () => {
    render(<CheckoutClient />);
    await screen.findByRole("heading", { name: "Review your order" });
    fireEvent.click(screen.getByText("Home Delivery"));
    const details = screen.getByTestId("order-review-details");
    expect(within(details).getByText("Enter your delivery address")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. Thabo Molefe"), { target: { value: "Erin Example" } });
    fireEvent.change(screen.getByPlaceholderText(/House|street|address/i), { target: { value: "12 Test Street, Bloemfontein" } });
    expect(within(details).getByText("12 Test Street, Bloemfontein")).toBeInTheDocument();
    expect(within(details).getByText(/Erin Example/)).toBeInTheDocument();
  });
});

describe("Distance-based delivery fee at checkout", () => {
  it("quotes the address, shows distance and fee, recalculates on change and sends the quote to the server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "stop here" } });
    const supabase = await import("@/lib/supabase");
    vi.mocked(supabase.createBrowserClient).mockReturnValue({ auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) }, rpc } as never);
    const quotes: Record<string, unknown> = {
      "12 test street, bloemfontein": { quoteId: "q-1", address: "12 Test Street, Bloemfontein", distanceKm: 3.27, durationMinutes: 9, deliveryFee: 28.08, baseFee: 15, pricePerKm: 4, minFee: 20, maxDistanceKm: 15, freeDeliveryThreshold: null, withinRange: true, expiresAt: "" },
      "99 far away road, bloemfontein": { quoteId: "q-2", address: "99 Far Away Road, Bloemfontein", distanceKm: 10, durationMinutes: 20, deliveryFee: 55, baseFee: 15, pricePerKm: 4, minFee: 20, maxDistanceKm: 15, freeDeliveryThreshold: null, withinRange: true, expiresAt: "" },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/delivery/quote")) {
        const address = String(JSON.parse(String(init?.body)).address).toLowerCase();
        return new Response(JSON.stringify(quotes[address] ?? { error: "We couldn't find that address.", code: "address_not_found" }), { status: quotes[address] ? 200 : 422 });
      }
      return new Response(JSON.stringify({ available: true, mode: "test" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CheckoutClient />);
    await screen.findByRole("heading", { name: "Review your order" });
    fireEvent.click(screen.getByText("Home Delivery"));
    const payButton = () => screen.getByRole("button", { name: /Pay by card/ });
    expect(payButton()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/House|street|address/i), { target: { value: "12 Test Street, Bloemfontein" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await screen.findByText(/3\.27 km by road • Delivery R28\.08/)).toBeInTheDocument();
    expect(screen.getByText(/R15\.00 \+ 3\.27 km × R4\.00/)).toBeInTheDocument();
    expect(payButton()).toHaveTextContent("R128.08");

    fireEvent.change(screen.getByPlaceholderText(/House|street|address/i), { target: { value: "99 Far Away Road, Bloemfontein" } });
    expect(payButton()).toBeDisabled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await screen.findByText(/10\.00 km by road • Delivery R55\.00/)).toBeInTheDocument();
    expect(payButton()).toHaveTextContent("R155.00");

    fireEvent.change(screen.getByPlaceholderText("e.g. Thabo Molefe"), { target: { value: "Erin Example" } });
    fireEvent.change(screen.getByPlaceholderText("+27 71 234 5678"), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(payButton());
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_order_type: "delivery", p_expected_total: 155, p_delivery_quote_id: "q-2", p_delivery_address: "99 Far Away Road, Bloemfontein" });
    vi.useRealTimers();
  });

  it("explains unknown addresses and keeps payment blocked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const supabase = await import("@/lib/supabase");
    vi.mocked(supabase.createBrowserClient).mockReturnValue({ auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } as never);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).startsWith("/api/delivery/quote")
      ? new Response(JSON.stringify({ error: "We couldn't find that address. Add the house number, street and suburb, then try again.", code: "address_not_found" }), { status: 422 })
      : new Response(JSON.stringify({ available: true, mode: "test" }))));
    render(<CheckoutClient />);
    await screen.findByRole("heading", { name: "Review your order" });
    fireEvent.click(screen.getByText("Home Delivery"));
    fireEvent.change(screen.getByPlaceholderText(/House|street|address/i), { target: { value: "qwzxv plkjh nowhere" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await screen.findByText(/couldn't find that address/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pay by card/ })).toBeDisabled();
    vi.useRealTimers();
  });
});
