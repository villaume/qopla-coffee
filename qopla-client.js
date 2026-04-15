/**
 * Qopla GraphQL API client for subscription coffee ordering.
 *
 * Two API endpoints:
 *   - userapi.qopla.com/graphql  — login, user account
 *   - api.qopla.com/graphql      — shop, menu, orders, subscriptions
 */

const USER_API = 'https://userapi.qopla.com/graphql';
const SHOP_API = 'https://api.qopla.com/graphql';

// Brod & Salt Torsplan
const SHOP_PUBLIC_ID = 'qGoXJ14ooQ';
const SHOP_ID = '647d84783911022f09e86449';
const COMPANY_ID = '60b8f7f377de9a24fca3f6e3';
const MENU_IDS = ['677ff2227c05d7633a1dbf44', '677fd965f473257716a9e395'];

const COMMON_HEADERS = {
  'accept': '*/*',
  'content-type': 'application/json',
  'origin': 'https://qopla.com',
  'referer': 'https://qopla.com/',
};

/**
 * Extract the access token from a cookie string like
 * "qJwtAccessToken=eyJ...; qJwtRefreshToken=eyJ..."
 */
function extractAccessToken(cookieString) {
  const match = cookieString?.match(/qJwtAccessToken=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Make a GraphQL request. Returns { data, cookies } where cookies is the
 * raw Set-Cookie header (needed to pass auth cookies between requests).
 */
async function gql(endpoint, { operationName, variables, query }, cookies = null) {
  const headers = { ...COMMON_HEADERS };
  if (cookies) {
    headers['cookie'] = cookies;
    // Shop API also accepts Bearer token extracted from the JWT cookie
    const token = extractAccessToken(cookies);
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
  }

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationName, variables, query }),
      });
      break;
    } catch (err) {
      if (attempt === 2) {
        const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
        throw new Error(`fetch failed after 3 attempts${cause}: ${endpoint}`);
      }
      // Brief pause before retry
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL request failed (${res.status}): ${text}`);
  }

  // Collect Set-Cookie headers for session management
  const setCookies = res.headers.getSetCookie?.() || [];
  const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');

  // Merge new cookies with existing ones
  const mergedCookies = mergeCookies(cookies, newCookies);

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return { data: json.data, cookies: mergedCookies };
}

function mergeCookies(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const map = new Map();
  for (const str of [existing, incoming]) {
    for (const pair of str.split('; ')) {
      const [key] = pair.split('=');
      if (key) map.set(key, pair);
    }
  }
  return [...map.values()].join('; ');
}

/**
 * Login to Qopla. Returns { userAccountId, cookies }.
 */
export async function login(email, password) {
  const { data, cookies } = await gql(USER_API, {
    operationName: 'loginUserAccountMutation',
    variables: { input: { email, password } },
    query: `mutation loginUserAccountMutation($input: LoginInput!) {
  loginUserAccount(input: $input) {
    ... on Error { path message __typename }
    ... on UserAccount {
      id
      contactInformation { email name lastName __typename }
      __typename
    }
    __typename
  }
}`,
  });

  // Response can be an array (union type) — unwrap it
  const raw = data.loginUserAccount;
  const result = Array.isArray(raw) ? raw[0] : raw;
  if (!result || result.__typename === 'Error') {
    throw new Error(`Login failed: ${result?.message || 'unknown error'}`);
  }

  return {
    userAccountId: result.id,
    name: result.contactInformation?.name || email,
    cookies,
  };
}

/**
 * Get the user's active subscription for this shop.
 * Returns { userSubscriptionId, subscriptionId, subscriptionName, latestOrderTimestamp, status }.
 */
export async function getSubscription(userAccountId, cookies) {
  const { data } = await gql(SHOP_API, {
    operationName: 'getUserSubscriptionsByShopIdQuery',
    variables: { userAccountId, shopId: SHOP_ID },
    query: `query getUserSubscriptionsByShopIdQuery($userAccountId: String, $shopId: String) {
  getUserSubscriptionsByShopId(userAccountId: $userAccountId, shopId: $shopId) {
    ... on UserSubscriptionDTO {
      id
      status
      subscriptionId
      latestOrderTimestamp
      subscription {
        ... on Subscription {
          id
          name
          subscriptionProducts { refProductId percentageDiscount amountDiscount __typename }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`,
  }, cookies);

  const raw = data.getUserSubscriptionsByShopId;
  const subs = Array.isArray(raw) ? raw : [raw].filter(Boolean);
  const active = subs.find(s => s.status === 'ACTIVE');
  if (!active) {
    throw new Error('No active subscription found for this shop');
  }

  return {
    userSubscriptionId: active.id,
    subscriptionId: active.subscriptionId,
    subscriptionName: active.subscription?.name || 'Unknown',
    latestOrderTimestamp: active.latestOrderTimestamp,
    status: active.status,
    subscriptionProducts: active.subscription?.subscriptionProducts || [],
  };
}

/**
 * Get the minimum purchase interval (in milliseconds) from company settings.
 */
export async function getMinimumPurchaseInterval(cookies) {
  const { data } = await gql(SHOP_API, {
    operationName: 'getCompanySubscriptionSettingsByIdQuery',
    variables: { companyId: COMPANY_ID },
    query: `query getCompanySubscriptionSettingsByIdQuery($companyId: String!) {
  getCompanySubscriptionSettingsById(companyId: $companyId) {
    minimumPurchaseInterval
    title
    __typename
  }
}`,
  }, cookies);

  // Value is in milliseconds (e.g. 7200000 = 2 hours)
  return data.getCompanySubscriptionSettingsById?.minimumPurchaseInterval || 7200000;
}

/**
 * Load the menu for this shop. Returns the full menu data including product categories and products.
 */
export async function getMenu(cookies) {
  const { data } = await gql(SHOP_API, {
    operationName: 'getWebOnlineCoreData',
    variables: { shopId: SHOP_ID, menuIds: MENU_IDS },
    query: `query getWebOnlineCoreData($shopId: String!, $menuIds: [String]) {
  getMenusByIds: getMenusByIdsForOnlineOrder(menuIds: $menuIds, shopId: $shopId) {
    id
    name
    menuProductCategories {
      id
      name
      menuProducts {
        id
        price
        refProduct {
          id
          name
          defaultPrice
          vatRate
          vatRateTakeAway
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`,
  }, cookies);

  return data.getMenusByIds;
}

/**
 * Check if the user can order now (2-hour cooldown).
 * @param latestOrderTimestamp - ISO date string or epoch of last order
 * @param minimumPurchaseIntervalMs - interval in milliseconds (e.g. 7200000)
 * Returns { canOrder, minutesRemaining, nextOrderTime }.
 */
export function checkCooldown(latestOrderTimestamp, minimumPurchaseIntervalMs) {
  if (!latestOrderTimestamp) {
    return { canOrder: true, minutesRemaining: 0, nextOrderTime: null };
  }

  const lastOrder = new Date(latestOrderTimestamp);
  const nextOrderTime = new Date(lastOrder.getTime() + minimumPurchaseIntervalMs);
  const now = new Date();
  const remaining = nextOrderTime.getTime() - now.getTime();

  if (remaining <= 0) {
    return { canOrder: true, minutesRemaining: 0, nextOrderTime };
  }

  return {
    canOrder: false,
    minutesRemaining: Math.ceil(remaining / 60000),
    nextOrderTime,
  };
}

/**
 * Place a subscription redemption order via addWebOrder mutation.
 *
 * @param {object} params
 * @param {string} params.userAccountId
 * @param {string} params.userSubscriptionId
 * @param {string} params.subscriptionId
 * @param {string} params.subscriptionName
 * @param {string} params.productName - display name of the product
 * @param {string} params.refProductId - product ID from the menu
 * @param {number} params.unitPrice - original price before subscription discount
 * @param {number} params.vatRate - VAT rate (e.g. 12)
 * @param {number} params.vatRateTakeAway - takeaway VAT rate (e.g. 6)
 * @param {string} params.refProductCategoryId - product category ID
 * @param {object} params.contactInformation - { name, email, phoneNumber }
 * @param {string} cookies
 */
export async function placeOrder(params, cookies) {
  const {
    userAccountId,
    userSubscriptionId,
    subscriptionId,
    subscriptionName,
    productName,
    refProductId,
    unitPrice,
    vatRate = 12,
    vatRateTakeAway = 6,
    refProductCategoryId = '6108f6a5a6b44c304e0b013d',
    contactInformation,
  } = params;

  const orderProductId = crypto.randomUUID();
  const anonymousUserId = crypto.randomUUID();
  const now = Date.now();

  const webOrderInput = {
    thirdPartyDelivery: null,
    tableMeta: null,
    shopId: SHOP_ID,
    eatingOption: 'EAT_HERE',
    cateringConfirmationHours: null,
    takeAway: false,
    homeDelivery: false,
    timeInterval: '',
    deliveryFee: 0,
    paymentInformation: { paymentMethod: 'NO_CHARGE' },
    subscriptionMeta: {
      userSubscriptionId,
      name: subscriptionName,
      subscriptionId,
    },
    giftCardMeta: null,
    discountMeta: {
      discounts: [{
        discountId: '',
        subscriptionDiscountId: subscriptionId,
        name: subscriptionName,
        code: '',
        discountValue: unitPrice,
        discountType: 'SUBSCRIPTION_DISCOUNT',
        qoplaSponsored: false,
      }],
      name: subscriptionName,
      amount: 0,
      rate: 1,
      originalPrice: unitPrice,
      totalDiscountValue: unitPrice,
    },
    orderProducts: [{
      id: orderProductId,
      name: productName,
      refProductId,
      menuCategoryId: subscriptionId,
      priceType: 'PRICE_PER_UNIT',
      refProductCategoryId,
      modifications: null,
      quantity: 1,
      shopId: SHOP_ID,
      addons: [],
      unitPrice: 0,
      totalPrice: 0,
      vatRate,
      vatRateTakeAway,
      totalNetPrice: 0,
      upsell: false,
      comment: '',
      refBundleProductId: null,
      selectedBundleProductItems: null,
      weight: 0,
      isLastOrderProduct: true,
      discountIds: [subscriptionId],
      combinedDiscounts: [{
        discountId: subscriptionId,
        name: subscriptionName,
        code: '',
        discountValue: unitPrice,
        discountRate: 1,
        discountedFrom: unitPrice,
        quantityUsedForDiscount: 1,
        discountType: 'SUBSCRIPTION_DISCOUNT',
        discountOrder: 1,
        qoplaSponsored: false,
      }],
      discountRate: 1,
      discountValue: unitPrice,
    }],
    pickupTime: null,
    contactInformation,
    invoiceData: null,
    deviceInformation: {
      isBrowser: true,
      browserMajorVersion: '146',
      browserFullVersion: '146.0.0.0',
      browserName: 'Chrome',
      engineName: 'Blink',
      engineVersion: '146.0.0.0',
      osName: 'Mac OS',
      osVersion: '10.15.7',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    webOrderType: 'BASIC',
    acceptsMarketing: false,
    userLanguage: 'sv',
    userAccountId,
    qr: 0,
    clientInformation: {
      frontendVersion: '1.1.0-1078',
      startTime: now - 2000,
      firstAddedOrder: now - 1000,
      checkoutTime: now - 500,
      purchaseTime: now,
    },
    tip: 0,
    anonymousUserId,
    source: null,
  };

  const { data } = await gql(SHOP_API, {
    operationName: 'addWebOrder',
    variables: { webOrderInput },
    query: `mutation addWebOrder($webOrderInput: WebOrderDTOInput) {
  addWebOrder(webOrderInput: $webOrderInput) {
    webPaymentResponse {
      operationSuccess
      errorText
      __typename
    }
    order {
      ... on Order {
        id
        orderNo
        totalAmount
        onlineOrderStatus
        purchaseDate
        __typename
      }
      __typename
    }
    __typename
  }
}`,
  }, cookies);

  const result = data.addWebOrder;
  if (!result?.webPaymentResponse?.operationSuccess) {
    const errorText = result?.webPaymentResponse?.errorText;
    const orderStatus = result?.order?.onlineOrderStatus;
    if (orderStatus === 'INVALID' && !result?.webPaymentResponse) {
      throw new Error('Order rejected by server (status: INVALID). This usually means the subscription cooldown has not elapsed — try again later.');
    }
    throw new Error(`Order failed: ${errorText || 'unknown error'}`);
  }

  return {
    orderId: result.order?.id,
    orderNo: result.order?.orderNo,
    totalAmount: result.order?.totalAmount,
    status: result.order?.onlineOrderStatus,
  };
}

export const constants = {
  SHOP_PUBLIC_ID,
  SHOP_ID,
  COMPANY_ID,
  MENU_IDS,
};
