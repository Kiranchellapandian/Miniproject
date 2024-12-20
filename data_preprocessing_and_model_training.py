# data_preprocessing_and_model_training.py

import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
import joblib

# Load dataset
data = pd.read_csv('bus_tracking_data_for_script.csv')

# Feature Engineering
data['hour'] = pd.to_datetime(data['timestamp']).dt.hour
data['day_of_week'] = pd.to_datetime(data['timestamp']).dt.dayofweek

# Selecting Features and Target
features = ['distance', 'hour', 'day_of_week', 'traffic_condition', 'bus_speed']
target = 'eta'

X = data[features]
y = data[target]

# Handling categorical features if any (e.g., traffic_condition)
X = pd.get_dummies(X, columns=['traffic_condition'], drop_first=True)

# Split the data
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Initialize and train the model
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# Predict and evaluate
predictions = model.predict(X_test)
mae = mean_absolute_error(y_test, predictions)
print(f'Mean Absolute Error: {mae}')

# Save the model
joblib.dump(model, 'eta_random_forest_model.joblib')
